import { logger } from "../../utils/logger";
import { Session } from "../session";
import { getRegisteredRequests, RequestBase } from "./request-base";

type RequestConstructor = new (session: Session, params: any[]) => RequestBase;

export class RequestManager {
  private requests: Map<string, RequestConstructor> = new Map();

  init() {
    logger.info("Initializing RequestManager...");
    this.requests = getRegisteredRequests();

    logger.info(
      `Registered ${this.requests.size} request(s):`,
      Array.from(this.requests.keys()).join(", "),
    );
  }

  async handleRequest(
    session: Session,
    requestName: string,
    params: any[],
  ): Promise<void> {
    logger.silly(
      `Handling request: ${requestName} with params: ${JSON.stringify(params)}`,
    );

    const requestClass = this.requests.get(requestName);

    if (!requestClass) {
      logger.error(`Unknown request: ${requestName}`);
      return;
    }

    try {
      const request = new requestClass(session, params);
      await request.execute();
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Error executing request ${requestName}:`, error.message);
      }
    }
  }
}

export const requestManager = new RequestManager();
