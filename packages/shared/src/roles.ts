export const ROLES = ['OWNER', 'MANAGER', 'MODERATOR', 'WRITER'] as const;
export type RoleName = (typeof ROLES)[number];

export const PERMISSIONS = {
  'agency:manage': ['OWNER'],
  'team:manage': ['OWNER', 'MANAGER'],
  'clients:manage': ['OWNER', 'MANAGER'],
  'channels:manage': ['OWNER', 'MANAGER'],
  'clients:view-all': ['OWNER', 'MANAGER'],
  'inbox:reply': ['OWNER', 'MANAGER', 'MODERATOR'],
  'posts:write': ['OWNER', 'MANAGER', 'WRITER'],
  'posts:approve': ['OWNER', 'MANAGER'],
  'audit:view': ['OWNER', 'MANAGER']
} as const satisfies Record<string, readonly RoleName[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: RoleName, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly RoleName[]).includes(role);
}

export const ROLE_LABELS_AR: Record<RoleName, string> = {
  OWNER: 'صاحب الوكالة',
  MANAGER: 'مدير',
  MODERATOR: 'مودريتور',
  WRITER: 'كاتب محتوى'
};
