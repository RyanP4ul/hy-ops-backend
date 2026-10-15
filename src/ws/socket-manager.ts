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
      page: "dashboard",
      ip_address,
      started_at: Date.now(),
    });
  }

  public removeSocket(id: string) {
    this.sockets.delete(id);
  }
}

export const socketManager = new SocketManager();
