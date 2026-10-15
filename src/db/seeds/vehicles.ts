import { db } from "..";
import { vehicles, VehicleInsert } from "../schema/vehicles";
import { logger } from "../../utils/logger";

const vehicle_data: VehicleInsert[] = [
  {
    plate_number: "ABC-1234",
    status: "available",
    type: "truck",
    image: "/vehicles/truck.svg",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
  {
    plate_number: "XYZ-5678",
    status: "maintenance",
    type: "van",
    image: "/vehicles/van.svg",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
];

export async function vehicleSeeds() {
  try {
    await db.insert(vehicles).values(vehicle_data);
    logger.info("Vehicle seed completed successfully.");
  } catch (error) {
    logger.error(
      "Error seeding vehicles:",
      error instanceof Error ? error.message : error,
    );
  }
}
