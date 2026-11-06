import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { AuthStore, AuthStoreStates } from '@/typings/stores/app.store';

const defaultFields: AuthStoreStates = {
  email: undefined,
};

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      ...defaultFields,
      logout: () => set({}),
      resetStore: () => set(defaultFields),
      setTokens: (a) =>
        set({
          email: a.email,
        }),
    }),
    {
      name: 'auth', // Unique key for the browser storage item
    },
  ),
);
