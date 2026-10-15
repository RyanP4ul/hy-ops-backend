import { logger } from "../utils/logger";

export const roleHierarchy: Record<string, number> = {
  admin: 3,
  staff: 2,
  driver: 1,
  user: 0,
};

export const checkRole = (user: any, requiredRoles: string[]) => {
  const userRoleLevel = roleHierarchy[user.role] || 0;
  const requiredRoleLevels = requiredRoles.map(
    (role) => roleHierarchy[role] || 0,
  );
  const maxRequiredRoleLevel = Math.max(...requiredRoleLevels);

  if (userRoleLevel < maxRequiredRoleLevel) {
    logger.warning(
      `Access denied for ${user.role}. Required role: ${requiredRoles.join(", ")}`,
    );
    return false;
  }
  return false;
};

export const requireRole = (
  requiredRole: string[],
  { user, set }: { user: any; set: any },
) => {
  if (!checkRole(user, requiredRole)) {
    set.status = 403;
    return {
      success: false,
      message: "You do not have permission to access this resource.",
    };
  }
};
