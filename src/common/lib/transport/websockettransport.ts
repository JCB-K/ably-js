import Platform from 'common/platform';
import * as Utils from '../util/utils';
import Transport, { TryConnectCallback } from './transport';
import Defaults from '../util/defaults';
import Logger from '../util/logger';
import ProtocolMessage from '../types/protocolmessage';
import ErrorInfo from '../types/errorinfo';
import NodeWebSocket from 'ws';
import ConnectionManager, { TransportParams } from './connectionmanager';
import Auth from '../client/auth';

const shortName = 'web_socket';

function isNodeWebSocket(ws: WebSocket | NodeWebSocket): ws is NodeWebSocket {
  return !!(ws as NodeWebSocket).on;
}

class WebSocketTransport extends Transport {
  shortName = shortName;
  wsHost: string;
  uri?: string;
  wsConnection?: WebSocket | NodeWebSocket;

  constructor(connectionManager: ConnectionManager, auth: Auth, params: TransportParams) {
    super(connectionManager, auth, params);
    /* If is a browser, can't detect pings, so request protocol heartbeats */
    params.heartbeats = Platform.Config.useProtocolHeartbeats;
    this.wsHost = Defaults.getHost(params.options, params.host, true);
  }

  static isAvailable() {
    return !!Platform.Config.WebSocket;
  }

  static tryConnect(
    connectionManager: ConnectionManager,
    auth: Auth,
    params: TransportParams,
    callback: TryConnectCallback
  ) {
    const transport = new WebSocketTransport(connectionManager, auth, params);
    const errorCb = function (this: { event: string }, err: ErrorInfo) {
      callback({ event: this.event, error: err });
    };
    transport.on(['failed', 'disconnected'], errorCb);
    transport.on('wsopen', function () {
      Logger.logAction(Logger.LOG_MINOR, 'WebSocketTransport.tryConnect()', 'viable transport ' + transport);
      transport.off(['failed', 'disconnected'], errorCb);
      callback(null, transport);
    });
    transport.connect();
  }

  createWebSocket(uri: string, connectParams: Record<string, string>) {
    let paramCount = 0;
    if (connectParams) {
      for (const key in connectParams) uri += (paramCount++ ? '&' : '?') + key + '=' + connectParams[key];
    }
    this.uri = uri;
    return new Platform.Config.WebSocket(uri);
  }

  toString() {
    return 'WebSocketTransport; uri=' + this.uri;
  }

  connect() {
    Logger.logAction(Logger.LOG_MINOR, 'WebSocketTransport.connect()', 'starting');
    Transport.prototype.connect.call(this);
    const self = this,
      params = this.params,
      options = params.options;
    const wsScheme = options.tls ? 'wss://' : 'ws://';
    const wsUri = wsScheme + this.wsHost + ':' + Defaults.getPort(options) + '/';
    Logger.logAction(Logger.LOG_MINOR, 'WebSocketTransport.connect()', 'uri: ' + wsUri);
    this.auth.getAuthParams(function (err: ErrorInfo, authParams: Record<string, string>) {
      if (self.isDisposed) {
        return;
      }
      let paramStr = '';
      for (const param in authParams) paramStr += ' ' + param + ': ' + authParams[param] + ';';
      Logger.logAction(Logger.LOG_MINOR, 'WebSocketTransport.connect()', 'authParams:' + paramStr + ' err: ' + err);
      if (err) {
        self.disconnect(err);
        return;
      }
      const connectParams = params.getConnectParams(authParams);
      try {
        const wsConnection = (self.wsConnection = self.createWebSocket(wsUri, connectParams));
        wsConnection.binaryType = Platform.Config.binaryType;
        wsConnection.onopen = function () {
          self.onWsOpen();
        };
        wsConnection.onclose = function (ev: CloseEvent) {
          self.onWsClose(ev);
        };
        wsConnection.onmessage = function (ev: MessageEvent) {
          self.onWsData(ev.data);
        };
        wsConnection.onerror = function (ev: Event) {
          self.onWsError(ev as ErrorEvent);
        };
        if (isNodeWebSocket(wsConnection)) {
          /* node; browsers currently don't have a general eventemitter and can't detect
           * pings. Also, no need to reply with a pong explicitly, ws lib handles that */
          wsConnection.on('ping', function () {
            self.onActivity();
          });
        }
      } catch (e) {
        Logger.logAction(
          Logger.LOG_ERROR,
          'WebSocketTransport.connect()',
          'Unexpected exception creating websocket: err = ' + ((e as Error).stack || (e as Error).message)
        );
        self.disconnect(e as Error);
      }
    });
  }

  send(message: ProtocolMessage) {
    const wsConnection = this.wsConnection;
    if (!wsConnection) {
      Logger.logAction(Logger.LOG_ERROR, 'WebSocketTransport.send()', 'No socket connection');
      return;
    }
    try {
      wsConnection.send(ProtocolMessage.serialize(message, this.params.format));
    } catch (e) {
      const msg = 'Exception from ws connection when trying to send: ' + Utils.inspectError(e);
      Logger.logAction(Logger.LOG_ERROR, 'WebSocketTransport.send()', msg);
      /* Don't try to request a disconnect, that'll just involve sending data
       * down the websocket again. Just finish the transport. */
      this.finish('disconnected', new ErrorInfo(msg, 50000, 500));
    }
  }

  onWsData(data: string) {
    Logger.logAction(
      Logger.LOG_MICRO,
      'WebSocketTransport.onWsData()',
      'data received; length = ' + data.length + '; type = ' + typeof data
    );
    try {
      this.onProtocolMessage(ProtocolMessage.deserialize(data, this.format));
    } catch (e) {
      Logger.logAction(
        Logger.LOG_ERROR,
        'WebSocketTransport.onWsData()',
        'Unexpected exception handing channel message: ' + (e as Error).stack
      );
    }
  }

  onWsOpen() {
    Logger.logAction(Logger.LOG_MINOR, 'WebSocketTransport.onWsOpen()', 'opened WebSocket');
    this.emit('wsopen');
  }

  onWsClose(ev: number | CloseEvent) {
    let wasClean, code;
    if (typeof ev == 'object') {
      /* W3C spec-compatible */
      code = ev.code;
      // ev.wasClean is undefined in reactnative
      wasClean = ev.wasClean || code === 1000;
    } /*if(typeof(ev) == 'number')*/ else {
      /* ws in node */
      code = ev;
      wasClean = code == 1000;
    }
    delete this.wsConnection;
    if (wasClean) {
      Logger.logAction(Logger.LOG_MINOR, 'WebSocketTransport.onWsClose()', 'Cleanly closed WebSocket');
      const err = new ErrorInfo('Websocket closed', 80003, 400);
      this.finish('disconnected', err);
    } else {
      const msg = 'Unclean disconnection of WebSocket ; code = ' + code,
        err = new ErrorInfo(msg, 80003, 400);
      Logger.logAction(Logger.LOG_MINOR, 'WebSocketTransport.onWsClose()', msg);
      this.finish('disconnected', err);
    }
    this.emit('disposed');
  }

  onWsError(err: ErrorEvent) {
    Logger.logAction(Logger.LOG_MINOR, 'WebSocketTransport.onError()', 'Error from WebSocket: ' + err.message);
    /* Wait a tick before aborting: if the websocket was connected, this event
     * will be immediately followed by an onclose event with a close code. Allow
     * that to close it (so we see the close code) rather than anticipating it */
    Platform.Config.nextTick(() => {
      this.disconnect(Error(err.message));
    });
  }

  dispose() {
    Logger.logAction(Logger.LOG_MINOR, 'WebSocketTransport.dispose()', '');
    this.isDisposed = true;
    const wsConnection = this.wsConnection;
    if (wsConnection) {
      /* Ignore any messages that come through after dispose() is called but before
       * websocket is actually closed. (mostly would be harmless, but if it's a
       * CONNECTED, it'll re-tick isConnected and cause all sorts of havoc) */
      wsConnection.onmessage = function () {};
      delete this.wsConnection;
      /* defer until the next event loop cycle before closing the socket,
       * giving some implementations the opportunity to send any outstanding close message */
      Platform.Config.nextTick(function () {
        Logger.logAction(Logger.LOG_MICRO, 'WebSocketTransport.dispose()', 'closing websocket');
        if (!wsConnection) {
          throw new Error('WebSocketTransport.dispose(): wsConnection is not defined');
        }
        wsConnection.close();
      });
    }
  }
}

function initialiseTransport(connectionManager: any): typeof WebSocketTransport {
  if (WebSocketTransport.isAvailable()) connectionManager.supportedTransports[shortName] = WebSocketTransport;

  return WebSocketTransport;
}

export default initialiseTransport;
