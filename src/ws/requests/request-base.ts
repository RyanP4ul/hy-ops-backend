import z from "zod";
import { logger } from "../../utils/logger";
import { Session } from "../session";
import { socketManager } from "../socket-manager";
import { TOPIC } from "../topic";

const requestRegistry = new Map<
  string,
  new (session: Session, params: any[]) => RequestBase<any>
>();

export function Request(command: string) {
  return function <T extends new (...args: any[]) => RequestBase<any>>(
    constructor: T,
  ) {
    requestRegistry.set(command, constructor as any);
    return constructor;
  };
}

export function getRegisteredRequests() {
  return requestRegistry;
}

export abstract class RequestBase<TSchema extends z.ZodTypeAny = z.ZodAny> {
  protected session: Session;
  protected data: z.infer<TSchema> = undefined as any;
  protected skipValidation: boolean = false;

  static schema: z.ZodTypeAny = z.any();

  constructor(session: Session, params: any[]) {
    this.session = session;

    const schema = (this.constructor as typeof RequestBase).schema;

    if (this.skipValidation) {
      this.data = params as z.infer<TSchema>;
      return;
    }

    const result = schema.safeParse(params);

    if (!result.success) {
      const firstError = result.error.issues[0];
      logger.error(
        `Request parameters validation failed: ${firstError?.message || "Unknown error"}`,
      );
      return;
    }

    // if (!result.success && character.properties.access >= 60) {
    //   const firstError = result.error.issues[0];
    //   throw new InvalidParametersException(
    //     "Request parameters validation failed",
    //     firstError.message,
    //   );
    // }

    this.data = result.data as z.infer<TSchema>;
  }

  protected write(data: any) {
    this.session.ws.send(data);
  }

  protected publish(data: any, topic: string | string[] = this.session.page) {
    if (Array.isArray(topic)) {
      for (const t of topic) {
        this.session.ws.publish(t, data);
      }
    } else {
      this.session.ws.publish(topic, data);
    }
  }

  protected publishBySubscribed(
    data: any,
    topic: string,
    excludeSocketId: string[] = [],
  ) {
    const sessions = socketManager.getSockets();

    for (const session of sessions.values()) {
      if (
        excludeSocketId.includes(session.ws.id) ||
        !session.ws.isSubscribed(topic)
      )
        continue;
      session.ws.send(data);
    }
  }

  protected publishExcept(data: any, excludeSocketId: string) {
    const target_session = socketManager.getSocket(excludeSocketId);

    if (!target_session) return;

    const sessions = socketManager.getSockets();

    for (const [socketId, session] of sessions) {
      if (
        socketId === excludeSocketId ||
        !session.ws.isSubscribed(target_session.page)
      )
        continue;
      session.ws.send(session.page, data);
    }
  }

  abstract execute(): void | Promise<void>;
}
