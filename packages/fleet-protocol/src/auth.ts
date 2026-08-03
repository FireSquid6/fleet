import { z } from "zod";
import { FleetIdentifierSchema } from "./identifier";

export const RoleSchema = z.enum(["admin", "member"]);

export type Role = z.infer<typeof RoleSchema>;

export const UsernameSchema = FleetIdentifierSchema;

export const PasswordSchema = z.string().min(8).max(1024);

/** 320 is the RFC 5321 maximum: a 64-byte local part, `@`, and a 255-byte domain. */
export const EmailSchema = z.email().max(320);

export const UserSchema = z.object({
  id: z.string(),
  username: UsernameSchema,
  email: EmailSchema,
  role: RoleSchema,
  /** Unix epoch milliseconds. */
  createdAt: z.number(),
});

export type User = z.infer<typeof UserSchema>;

export const LoginRequestSchema = z.object({
  username: UsernameSchema,
  /** Not `PasswordSchema`: a login must not leak the password policy of the day. */
  password: z.string().min(1).max(1024),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  token: z.string(),
  user: UserSchema,
});

export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const CreateUserRequestSchema = z.object({
  username: UsernameSchema,
  email: EmailSchema,
  password: PasswordSchema,
  role: RoleSchema.default("member"),
});

export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const SetPasswordRequestSchema = z.object({
  password: PasswordSchema,
});

export type SetPasswordRequest = z.infer<typeof SetPasswordRequestSchema>;

export const SetEmailRequestSchema = z.object({
  email: EmailSchema,
});

export type SetEmailRequest = z.infer<typeof SetEmailRequestSchema>;

export const SetRoleRequestSchema = z.object({
  role: RoleSchema,
});

export type SetRoleRequest = z.infer<typeof SetRoleRequestSchema>;

export const WsTicketResponseSchema = z.object({
  ticket: z.string(),
  /** Unix epoch milliseconds. */
  expiresAt: z.number(),
});

export type WsTicketResponse = z.infer<typeof WsTicketResponseSchema>;
