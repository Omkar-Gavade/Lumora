import type { StorageUsageDto, UserDto } from '@lumora/shared';
import { request } from '@/lib/api/client';

/**
 * Account self-service (docs/04-data-and-api.md §2.2).
 *
 * Thin wrappers over the shared client, which owns the access token, the
 * single-flight refresh, and the session-expired handler. Passwords are passed
 * straight through as arguments and never held in a module variable — the only
 * copy that exists is the one React state holds for as long as the form is on
 * screen.
 */

export function getProfile(): Promise<UserDto> {
  return request<UserDto>('/users/me');
}

export function updateProfile(displayName: string): Promise<UserDto> {
  return request<UserDto>('/users/me', { method: 'PATCH', body: { displayName } });
}

export function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  return request<undefined>('/users/me/password', { method: 'POST', body: input });
}

export function deleteAccount(password: string): Promise<void> {
  return request<undefined>('/users/me', { method: 'DELETE', body: { password } });
}

export function getUsage(): Promise<StorageUsageDto> {
  return request<StorageUsageDto>('/users/me/usage');
}
