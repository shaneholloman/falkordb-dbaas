import { ApiError } from '@falkordb/errors';
import { decode, JwtPayload } from 'jsonwebtoken';

export const getRequestorId = (authorization?: string): string => {
  const token = authorization?.split(' ').pop();
  const payload = token ? decode(token) : null;
  if (!payload || typeof payload === 'string' || typeof (payload as JwtPayload).userID !== 'string') {
    throw ApiError.unauthorized('Invalid token', 'INVALID_TOKEN');
  }
  return (payload as JwtPayload).userID;
};