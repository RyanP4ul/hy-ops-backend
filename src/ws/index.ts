import Elysia, { t } from "elysia";
import { logger } from "../utils/logger";
import { socketManager } from "./socket-manager";
import { AuthUser } from "../modules/auth/schema";
import { parseUserAgent } from "../utils/headers";
import { requestManager } from "./requests/request-manager";
import { WebSocketData } from "@/types/ws";
import { TOPIC } from "./topic";
import { sessionService } from "../modules/session/service";

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
	  
	  console.log("ws.data.headers: " + JSON.stringify(ws.data.headers));

      const user: AuthUser = {
        sub: ws.data.user.sub,
        email: ws.data.user.email,
        name: ws.data.user.name,
        role: ws.data.user.role,
        token_version: ws.data.user.token_version,
        user_agent: user_agent,
        iat: ws.data.user.iat,
      };

      socketManager.addSocket(ws, ip_address, user);

      ws.subscribe(TOPIC.GLOBAL);

      // HANDSHAKE

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
          payload: data !== null ? JSON.stringify(data.payload) : "none",
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
            payload:
              data.payload !== undefined
                ? JSON.stringify(data.payload)
                : "none",
          },
        });

        requestManager.handleRequest(session, data.type, data.payload);
      } catch (error) {
        logger.error(`Error parsing message: ${error}`);
      }
    },
    close(ws) {
      logger.info(`WebSocket connection closed with code: ${ws.id}`);

      const session = socketManager.getSocket(ws.id);

      if (session !== undefined) {
        requestManager.handleRequest(session, "SESSION_OUT", [ws.id]);
      }

      socketManager.removeSocket(ws.id);
    },
  });
