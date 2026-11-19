import { AuthUser } from "../modules/auth/schema";
import { logger } from "../utils/logger";
import { Session } from "./session";

export class SocketManager {
  private sockets: Map<string, Session> = new Map();

  public getSockets(): Map<string, Session> {
    return this.sockets;
  }

  // public getSocketUserId(socketId: string): string | undefined {
  //   const socket = this.sockets.get(socketId);
  //   return socket ? socket.user.sub : undefined;
  // }

  public getSocket(id: string): Session | undefined {
    const socket = this.sockets.get(id);
    if (!socket) {
      logger.warning(`Socket with id ${id} not found`);
      return undefined;
    }
    return socket;
  }

  public addSocket(ws: any, ip_address: string, user: AuthUser) {
    this.sockets.set(ws.id, {
      ws: ws,
      user,
      page: user.role === "driver" ? "mobile" : "dashboard",
      ip_address,
      started_at: Date.now(),
    });
  }

  public removeSocket(id: string) {
    this.sockets.delete(id);
  }

  public broadcastToTopic(
    topic: string,
    event: unknown,
    options?: { excludeSocketId?: string; allowedRoles?: readonly string[] },
  ) {
    const serialized =
      typeof event === "string" ? event : JSON.stringify(event);

    for (const session of this.sockets.values()) {
      if (options?.excludeSocketId && session.ws.id === options.excludeSocketId)
        continue;
      if (
        options?.allowedRoles &&
        !options.allowedRoles.includes(String(session.user.role))
      )
        continue;
      if (session.page !== topic && !session.ws.isSubscribed(topic)) continue;

      try {
        session.ws.send(serialized);
      } catch {
        // Ignore sockets that are already closing.
      }
    }
  }
}

export const socketManager = new SocketManager();
