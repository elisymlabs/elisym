import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';

interface UIState {
  currentFilter: string;
}

interface UIAction {
  type: 'SET_FILTER';
  filter: string;
}

const initialState: UIState = {
  currentFilter: 'all',
};

function uiReducer(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    case 'SET_FILTER':
      return { ...state, currentFilter: action.filter };
    default:
      return state;
  }
}

const UIContext = createContext<[UIState, Dispatch<UIAction>] | null>(null);

export function UIProvider({ children }: { children: ReactNode }) {
  const value = useReducer(uiReducer, initialState);
  return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
}

export function useUI(): [UIState, Dispatch<UIAction>] {
  const ctx = useContext(UIContext);
  if (!ctx) {
    throw new Error('useUI must be used within UIProvider');
  }
  return ctx;
}
