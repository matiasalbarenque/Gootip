export type AuthStoreStates = {
  email: string | undefined;
};

type AuthStoreActions = {
  logout: () => void;
  resetStore: () => void;
  setTokens: (states: Pick<AuthStoreStates, 'email'>) => void;
};

export type AuthStore = AuthStoreStates & AuthStoreActions;
