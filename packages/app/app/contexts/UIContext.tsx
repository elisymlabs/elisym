import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';

export type ViewMode = 'all' | 'new';

interface UIState {
  viewMode: ViewMode;
  selectedTags: string[];
}

type UIAction =
  | { type: 'SET_VIEW_MODE'; viewMode: ViewMode }
  | { type: 'TOGGLE_TAG'; tag: string }
  | { type: 'CLEAR_TAGS' };

const initialState: UIState = {
  viewMode: 'all',
  selectedTags: [],
};

function uiReducer(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    case 'SET_VIEW_MODE':
      return { ...state, viewMode: action.viewMode };
    case 'TOGGLE_TAG': {
      const exists = state.selectedTags.includes(action.tag);
      const selectedTags = exists
        ? state.selectedTags.filter((tag) => tag !== action.tag)
        : [...state.selectedTags, action.tag];
      return { ...state, selectedTags };
    }
    case 'CLEAR_TAGS':
      return { ...state, selectedTags: [] };
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
