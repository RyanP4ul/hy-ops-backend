import { UserRole } from "@/db/schema/users";
import { AuthUser } from "@/types/auth-user";

export interface Session {
  ws: any;
  ip_address: string;
  user: AuthUser;
  page: string;
  started_at: number;
}
