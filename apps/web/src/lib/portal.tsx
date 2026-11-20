'use client';
import { createContext, useContext } from 'react';

export type PortalMe = { user: { name: string }; client: { name: string; requiresClientApproval: boolean; accounts: { platform: string; name: string }[] }; agency: { name: string }; demo: boolean };
export const PortalContext = createContext<PortalMe | null>(null);
export const usePortalMe = () => useContext(PortalContext)!;
