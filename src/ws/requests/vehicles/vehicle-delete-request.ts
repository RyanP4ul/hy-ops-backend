import z from "zod";
import { RequestBase, Request } from "../request-base";
import { TOPIC } from "../../topic";

@Request("VEHICLE_DELETED")
export class DeleteVehicleHandler extends RequestBase<
  typeof DeleteVehicleHandler.schema
> {
  static override schema = z.tuple([z.number()]);

  override async execute(): Promise<void> {
    const [id] = this.data;

    if (!id) throw new Error("Invalid vehicle ID provided.");

    this.publishBySubscribed(
      { type: "VEHICLE_DELETED", payload: { id } },
      TOPIC.VEHICLES,
      [this.session.ws.id],
    );
  }
}
