import z from "zod";
import { RequestBase, Request } from "../request-base";
import { NotificationService } from "../../../modules/notifications/service";
import { TOPIC } from "../../topic";

// {
//   "delivery_id": "your_delivery_id",
//   "latitude": 14.8451724,
//   "longitude": 120.8796541,
//   "accuracy": 18.19700050354004,
//   "speed": 1.0299409627914429,
//   "heading": 304.7207946777344,
//   "recorded_at": "2026-10-19T05:56:43.935991Z"
// }

@Request("DRIVER_LOCATION_UPDATE")
export class CreateNotificationHandler extends RequestBase<
  typeof CreateNotificationHandler.schema
> {
  static override schema = z.tuple([
    z.number().int().min(1).nonnegative(),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(0),
    z.number().min(0),
    z.number().min(0).max(360),
    z.string().datetime(),
  ]);
  override skipValidation = false;

  override async execute(): Promise<void> {
    const [
      delivery_id,
      latitude,
      longitude,
      accuracy,
      speed,
      heading,
      recorded_at,
    ] = this.data;

    this.publish(
      {
        type: "DRIVER_LOCATION_UPDATE",
        payload: {
          delivery_id,
          latitude,
          longitude,
          accuracy,
          speed,
          heading,
          recorded_at,
        },
      },
      [TOPIC.DASHBOARD, TOPIC.FLEET_MAP],
    );
  }
}
