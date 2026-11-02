import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("DELIVERY_SCHEDULE_CREATED")
export class ScheduleCreatedHandler extends RequestBase<
  typeof ScheduleCreatedHandler.schema
> {
  static override schema = z.tuple([z.string()]);

  override async execute(): Promise<void> {
    const [scheduleData] = this.data;
    const schedule = JSON.parse(scheduleData) as {
      id: number;
      order_ids: number[];
    };

    if (!schedule?.id || !Array.isArray(schedule.order_ids)) {
      throw new Error("Invalid delivery schedule data provided.");
    }

    this.publishBySubscribed(
      {
        type: "DELIVERY_SCHEDULE_CREATED",
        payload: schedule,
      },
      TOPIC.DELIVERY_SCHEDULES,
      [this.session.ws.id],
    );
  }
}
