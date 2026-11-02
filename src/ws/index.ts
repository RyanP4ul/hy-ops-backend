import Elysia, { t } from "elysia";
import { UserService } from "../modules/user/service";
import { canSendRequest, canSubscribe } from "./authorization";
import { currentSession } from "../modules/auth/policy";
import { watchSession } from "./session-watch";
import { onSessionRevoked } from "../utils/session-events";
import { logger } from "../utils/logger";
import { socketManager } from "./socket-manager";
import { AuthUser } from "../modules/auth/schema";
import { parseUserAgent } from "../utils/headers";
import { requestManager } from "./requests/request-manager";
import { TOPIC } from "./topic";
import { sessionService } from "../modules/session/service";
const sessionWatches = new Map<string, () => void>();

export const ws = new Elysia()
  .decorate("user", AuthUser)
  .decorate("ip_address", String)
  .decorate("current_page", String)
  .ws("/ws", {
    body: t.Object({
      type: t.String({ minLength: 3, maxLength: 50 }),
      payload: t.Optional(t.Any()),
    }),

    async open(ws) {
      const user_agent = parseUserAgent(ws.data.headers["user-agent"] || null);
      const ip_address = String(ws.data.ip_address) || "unknown";
	  
	  logger.debug(`IP Address: ${ip_address}`);

      const user: AuthUser = {
        sub: ws.data.user.sub,
        email: ws.data.user.email,
        name: ws.data.user.name,
        role: ws.data.user.role,
        token_version: ws.data.user.token_version,
        user_agent: user_agent,
        iat: ws.data.user.iat,
        exp: ws.data.user.exp,
        token_type: ws.data.user.token_type,
      };

      // Account changes can commit between the HTTP upgrade guard and this callback.
      try {
        if (!currentSession(user, await UserService.getMutationActor(Number(user.sub)))) {
          ws.close(4001, "Session revoked"); return;
        }
      } catch {
        ws.close(4003, "Unable to verify session"); return;
      }
      socketManager.addSocket(ws, ip_address, user);
      const unwatch = watchSession(user.exp, async () =>
        currentSession(user, await UserService.getMutationActor(Number(user.sub))),
        (code, reason) => ws.close(code, reason));
      const unsubscribe = onSessionRevoked(Number(user.sub), () => ws.close(4001, "Session revoked"));
      sessionWatches.set(ws.id, () => { unwatch(); unsubscribe(); });

      if (["admin", "staff"].includes(String(user.role))) ws.subscribe(TOPIC.GLOBAL);

      ws.send(JSON.stringify({ type: "WS_READY", payload: null }));

      ws.publish(TOPIC.SESSION_AND_LOGS, {
        type: "NEW_SESSION",
        payload: {
          id: ws.id,
          ip_address: ip_address,
          page: "unknown",
          user: user,
        },
      });
    },
    async message(ws, message) {
      const session = socketManager.getSocket(ws.id);

      if (!session) {
        logger.warning(`Session not found for socket id: ${ws.id}`);
        return;
      }

      try {
        const actor = await UserService.getMutationActor(Number(session.user.sub));
        if (!currentSession(session.user, actor)) {
          const expired = session.user.exp <= Math.floor(Date.now() / 1000);
          ws.close(expired ? 4002 : 4001, expired ? "Access token expired" : "Session revoked");
          return;
        }
        if (!actor || !canSendRequest(actor.role, message.type)) {
          ws.send(JSON.stringify({ type: "WS_ERROR", payload: { message: "Request not permitted." } }));
          return;
        }
        if (message.type === "CHANGE_PAGE" && (!Array.isArray(message.payload) || message.payload.length !== 1 || typeof message.payload[0] !== "string" || !canSubscribe(actor.role, message.payload[0]))) {
          ws.send(JSON.stringify({ type: "WS_ERROR", payload: { message: "Subscription not permitted." } }));
          return;
        }
        const minimizedMessage = JSON.stringify(message);
        const data = JSON.parse(minimizedMessage);

        if (data === null) {
          logger.warning(`Received null payload from socket id: ${ws.id}`);
          return;
        }

        const log = await sessionService.createWsLogs({
          session_id: ws.id,
          user_id: session.user.sub,
          action: data.type,
          payload: "[OMITTED]",
          created_at: Math.floor(Date.now() / 1000),
          updated_at: Math.floor(Date.now() / 1000),
        });

        ws.publish(TOPIC.SESSION_AND_LOGS, {
          type: "WS_LOG_CREATED",
          payload: {
            ws_id: log.id,
            session_id: ws.id,
            user_id: session.user.sub,
            action: data.type,
            payload: "[OMITTED]",
          },
        });

        // Domain changes are published by successful HTTP mutations. Never trust
        // client-supplied records as authoritative cache updates on other clients.
        if (data.type === "CHANGE_PAGE" || data.type === "DRIVER_LOCATION_UPDATE") {
          const handled = await requestManager.handleRequest(session, data.type, data.payload);
          if (!handled) ws.send(JSON.stringify({ type: "WS_ERROR", payload: { message: "Request is invalid or not permitted." } }));
        }
      } catch (error) {
        logger.error("WebSocket request failed");
        // Do not keep a socket alive after its account can no longer be verified.
        ws.close(4003, "Unable to verify request");
      }
    },
    close(ws) {
      sessionWatches.get(ws.id)?.();
      sessionWatches.delete(ws.id);
      logger.info(`WebSocket connection closed with code: ${ws.id}`);

      const session = socketManager.getSocket(ws.id);

      if (session !== undefined) {
        requestManager.handleRequest(session, "SESSION_OUT", [ws.id]);
      }

      socketManager.removeSocket(ws.id);
    },
  });
