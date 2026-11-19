import { z } from 'zod';
import { ROLES } from './roles.js';

export const signupSchema = z.object({
  agencyName: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(80),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(10).max(200)
});

export const loginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1).max(200)
});

export const clientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(2000).optional()
});

export const inviteSchema = z.object({
  email: z.email().trim().toLowerCase(),
  role: z.enum(ROLES).exclude(['OWNER'])
});

export const acceptInviteSchema = z.object({
  token: z.string().min(20),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(10).max(200)
});

export const connectWhatsAppSchema = z.object({
  clientId: z.string().min(1),
  phoneNumberId: z.string().regex(/^\d+$/),
  wabaId: z.string().regex(/^\d+$/),
  accessToken: z.string().min(20)
});

export const connectSocialSchema = z.object({
  clientId: z.string().min(1),
  platform: z.enum(['FACEBOOK_PAGE', 'INSTAGRAM']),
  externalId: z.string().regex(/^\d+$/),
  name: z.string().trim().min(1).max(120),
  accessToken: z.string().min(20)
});

export const sendMessageSchema = z.object({ body: z.string().trim().min(1).max(4096) });

export const conversationUpdateSchema = z.object({
  status: z.enum(['OPEN', 'PENDING', 'CLOSED']).optional(),
  assigneeId: z.string().nullable().optional()
});

export const quickReplySchema = z.object({
  shortcut: z.string().trim().regex(/^[\p{L}\p{N}_-]{1,30}$/u),
  body: z.string().trim().min(1).max(4096)
});

export const postSchema = z.object({
  clientId: z.string().min(1),
  caption: z.string().trim().min(1).max(2200),
  mediaUrls: z.array(z.url()).max(1).default([]),
  socialAccountIds: z.array(z.string()).min(1),
  scheduledAt: z.coerce.date().nullable().optional()
});

export type SignupInput = z.infer<typeof signupSchema>;
export type PostInput = z.infer<typeof postSchema>;
