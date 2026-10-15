export abstract class AuthService {
  // checkRole(userRole: string, requiredRole: string, path: string): boolean {
  //   const roleHierarchy: Record<string, number> = {
  //     admin: 3,
  //     manager: 2,
  //     user: 1,
  //   };
  //   const pages = {
  //     "/panel/orders": "user",
  //     "/panel/inventory": "manager",
  //     "/panel/settings": "admin",
  //   };
  //   const userRoleLevel = roleHierarchy[userRole] || 0;
  //   const requiredRoleLevel = roleHierarchy[requiredRole] || 0;
  //   if (path in pages) {
  //     const pageRequiredRole = pages[path] as any;
  //     const pageRequiredRoleLevel = roleHierarchy[pageRequiredRole] || 0;
  //     if (userRoleLevel < pageRequiredRoleLevel) {
  //       console.log(
  //         `Access denied for ${userRole} on ${path}. Required role: ${pageRequiredRole}`,
  //       );
  //       return false;
  //     }
  //   }
  //   // if (userRoleLevel < requiredRoleLevel) {
  //   //   console.log(
  //   //     `Access denied for ${userRole} on ${path}. Required role: ${requiredRole}`,
  //   //   );
  //   //   return false;
  //   // }
  //   return true;
  // }
}
