import CID from 'cids';
import pushable from 'it-pushable';
import multibaseConstants from 'multibase/src/constants';
import multicodecLib from 'multicodec';
import multihash from 'multihashes';
import socketIO from 'socket.io-client';
import { hasOngoingDeals, ongoingDeals } from 'src/background/ongoingDeals';
import dealStatuses from 'src/shared/dealStatuses';
import getOptions from 'src/shared/getOptions.js';
import { addOffer } from 'src/shared/offers';

import { messageRequestTypes, messageResponseTypes, messages } from '../../shared/messages';
import { sha256 } from '../../shared/sha256';
import Datastore from '../Datastore';
import Lotus from '../lotus-client/Lotus';
import ports from '../ports';

/** @type {SocketClient} */
let singletonSocketClient;

export default class SocketClient {
  /** @type {Datastore} Datastore */
  datastore;

  /** @type {(cid: string, size: number) => void} */
  handleCidReceived;

  /** @type {ReturnType<socketIO>} Socket IO */
  socket;

  maxResendAttempts;

  /**
   * @param {{ datastore: Datastore }} services Services
   * @param {ReturnType<getOptions>} options Options
   * @param {{ handleCidReceived: (cid: string, size: number) => void }} Callbacks
   */
  static create({ datastore }, options, { handleCidReceived }) {
    if (singletonSocketClient) {
      return singletonSocketClient;
    }

    const client = new SocketClient();

    if (Datastore) {
      client.datastore = datastore;
    }

    client.handleCidReceived = handleCidReceived;

    client.maxResendAttempts = 3;

    client._initializeSocketIO(options);
    client._addHandlers();

    singletonSocketClient = client;

    return client;
  }

  decodeCID(value) {
    const cid = new CID(value).toJSON();
    const decoded = cid.version === 1 ? this.decodeCidV1(value, cid) : this.decodeCidV0(value, cid);

    if (!decoded) {
      throw new Error('Unknown CID version', cid.version, cid);
    }

    return {
      version: cid.version,
      hashAlg: decoded.multihash.name,
      rawLeaves: decoded.multicodec.name === 'raw',
      format: decoded.multicodec.name,
    };
  }

  decodeCidV0(value, cid) {
    return {
      cid,
      multibase: {
        name: 'base58btc',
        code: 'implicit',
      },
      multicodec: {
        name: cid.codec,
        code: 'implicit',
      },
      multihash: multihash.decode(cid.hash),
    };
  }

  decodeCidV1(value, cid) {
    return {
      cid,
      multibase: multibaseConstants.codes[value.substring(0, 1)],
      multicodec: {
        name: cid.codec,
        code: multicodecLib.getNumber(cid.codec),
      },
      multihash: multihash.decode(cid.hash),
    };
  }

  connect() {
    this.socket.open();
  }

  disconnect() {
    this.socket.close();
  }

  /**
   * @param {{ cid: string; minerID: string }} query query params
   */
  query({ cid, minerID }) {
    const getQueryCIDMessage = messages.createGetQueryCID({ cid, minerID });
    this.socket.emit(getQueryCIDMessage.message, getQueryCIDMessage);
  }

  async buy({ cid, params, multiaddr }) {
    try {
      const decoded = this.decodeCID(cid);
      ports.postLog(
        `DEBUG: SocketClient.buy: cidVersion ${decoded.version} hashAlg ${decoded.hashAlg} rawLeaves ${decoded.rawLeaves} format ${decoded.format}`,
      );

      this._createOngoingDeal({ cid, params, multiaddr, decoded });

      await this._sendFunds(params);

      this._setOngoingDealProps(params.clientToken, { status: dealStatuses.awaitingAcceptance });
    } catch (error) {
      ports.postLog(`ERROR: SocketClient._handleCidAvailability: error: ${error.message}`);
    }

    const options = await getOptions();

    this.socket.emit(
      messageRequestTypes.fundsConfirmed,
      messages.createFundsSent({ clientToken: params.clientToken, paymentWallet: options.wallet }),
    );
  }

  // Private:

  _initializeSocketIO({ wsEndpoint }) {
    this.socket = socketIO(wsEndpoint, { autoConnect: false, transports: ['websocket'] });
  }

  _addHandlers() {
    this._handleCidAvailability();
    this._handleFundsConfirmed();
    this._handleChunk();
  }

  _handleCidAvailability() {
    this.socket.on(messageResponseTypes.cidAvailability, async (message) => {
      console.log(`Got ${messageResponseTypes.cidAvailability} message:`, message);

      if (!message.available) {
        if (!hasOngoingDeals()) {
          this.socket.disconnect();
        }

        ports.alertError(`CID not available: ${message.cid}`);

        return;
      }

      await addOffer({
        cid: message.cid,
        params: {
          price: message.priceAttofil,
          size: message.approxSize,
          clientToken: message.clientToken,
          paymentWallet: message.paymentWallet,
        },
      });
    });
  }

  _handleFundsConfirmed() {
    this.socket.on(messageResponseTypes.fundsConfirmed, (message) => {
      console.log(messageResponseTypes.fundsConfirmed);
      console.log(message);

      // TODO: periodically send this message to check on status
      this.socket.emit(
        messageRequestTypes.queryRetrievalStatus,
        messages.createQueryRetrievalStatus({ cid: message.cid, clientToken: message.clientToken }),
      );
    });

    this.socket.on(messageResponseTypes.fundsConfirmedErrorInsufficientFunds, () => {
      // TODO: something
    });
    this.socket.on(messageResponseTypes.fundsConfirmedErrorPriceChanged, () => {
      // TODO: something
    });
  }

  _handleChunk() {
    this.socket.on(messageResponseTypes.chunk, async (message) => {
      console.log('got message from server: chunk');
      console.log('message', message);

      const deal = ongoingDeals[message.clientToken];

      // all chunks were received
      if (message.eof) {
        this._setOngoingDealProps(message.clientToken, {
          sizeReceived: deal.params.size,
          status: dealStatuses.finalizing,
        });

        deal.importerSink.end();

        this.handleCidReceived(message.cid, message.fullDataLenBytes);

        await this._closeDeal({ dealId: ongoingDeals[message.clientToken].id });

        return;
      }

      const dataBuffer = Buffer.from(message.chunkData, 'base64');
      const validSha256 = message.chunkSha256 === sha256(dataBuffer);
      const validSize = dataBuffer.length === message.chunkLenBytes;

      if (validSha256 && validSize) {
        this.socket.emit(
          messageRequestTypes.chunkReceived,
          messages.createChunkReceived({
            ...message,
          }),
        );

        // pushed data needs to be an array of bytes
        deal.importerSink.push([...dataBuffer]);

        deal.status = dealStatuses.ongoing;
        deal.sizeReceived += message.chunkLenBytes;

        this._setOngoingDealProps(message.clientToken, {
          sizeReceived: deal.sizeReceived + message.chunkLenBytes,
          status: dealStatuses.ongoing,
        });
      } else {
        if (this.maxResendAttempts > 0) {
          this.maxResendAttempts--;

          this.socket.emit(
            messageRequestTypes.chunkResend,
            messages.createChunkResend({
              ...message,
            }),
          );
        } else {
          // give up after N attempts
          this.socket.disconnect();
        }
      }
    });
  }

  _createOngoingDeal({ cid, params, multiaddr, decoded }) {
    const importerSink = pushable();

    const dealId = params.clientToken;

    ongoingDeals[dealId] = {
      id: dealId,
      status: dealStatuses.new,
      customStatus: undefined,
      cid,
      params,
      peerMultiaddr: multiaddr,
      peerWallet: params.paymentWallet,
      sink: pushable(),
      sizeReceived: 0,
      sizePaid: 0,
      importerSink,
      importer: this.datastore.putContent(importerSink, {
        cidVersion: decoded.version,
        hashAlg: decoded.hashAlg,
        rawLeaves: decoded.rawLeaves,
        format: decoded.format,
      }),
      voucherNonce: 1,
    };
    ports.postInboundDeals(ongoingDeals);
  }

  _setOngoingDealProps(clientToken, props) {
    ongoingDeals[clientToken] = {
      ...ongoingDeals[clientToken],
      ...props,
    };
    ports.postInboundDeals(ongoingDeals);
  }

  async _sendFunds(params) {
    ports.postLog(`DEBUG: SocketClient._handleCidAvailability: creating Lotus instance`);
    const lotus = await Lotus.create();
    ports.postLog(
      `DEBUG: SocketClient._handleCidAvailability: sending ${params.price} attofil to ${params.paymentWallet}`,
    );
    await lotus.sendFunds(params.price, params.paymentWallet);
  }

  async _closeDeal({ dealId }) {
    ports.postLog(`DEBUG: SocketClient.closeDeal: closing deal ${dealId}`);
    const deal = ongoingDeals[dealId];

    this._setOngoingDealProps(dealId, {
      customStatus: 'Done',
    });

    deal.sink.end();

    delete ongoingDeals[dealId];
    await this.handleCidReceived(deal.cid, deal.params.size);
    ports.postInboundDeals(ongoingDeals);
  }
}
