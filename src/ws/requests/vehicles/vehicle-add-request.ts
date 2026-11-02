import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("VEHICLE_ADDED")
export class AddVehicleHandler extends RequestBase<
  typeof AddVehicleHandler.schema
> {
  static override schema = z.tuple([z.string()]);

  override async execute(): Promise<void> {
    const [data] = this.data;
    const vehicle = JSON.parse(data);

    if (!vehicle?.id) throw new Error("Invalid vehicle data provided.");

    this.publishBySubscribed(
      { type: "VEHICLE_ADDED", payload: vehicle },
      TOPIC.VEHICLES,
      [this.session.ws.id],
    );
  }
}
