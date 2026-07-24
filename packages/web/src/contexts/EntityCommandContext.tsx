import type React from 'react';
import { createContext, useCallback, useContext, useMemo, useRef } from 'react';

type EntityCommands = {
  createFolder(): void;
  createNote(): void;
};

type EntityCommandContextValue = EntityCommands & {
  register(commands: EntityCommands): () => void;
};

const DEFAULT_ENTITY_COMMANDS: EntityCommandContextValue = {
  createFolder: () => {},
  createNote: () => {},
  register: () => () => {},
};

const EntityCommandContext = createContext<EntityCommandContextValue>(DEFAULT_ENTITY_COMMANDS);

export function EntityCommandProvider({ children }: { children: React.ReactNode }) {
  const commandsRef = useRef<EntityCommands | null>(null);
  const register = useCallback((commands: EntityCommands) => {
    commandsRef.current = commands;
    return () => {
      if (commandsRef.current === commands) commandsRef.current = null;
    };
  }, []);
  const createFolder = useCallback(() => commandsRef.current?.createFolder(), []);
  const createNote = useCallback(() => commandsRef.current?.createNote(), []);
  const value = useMemo(
    () => ({ createFolder, createNote, register }),
    [createFolder, createNote, register],
  );

  return <EntityCommandContext.Provider value={value}>{children}</EntityCommandContext.Provider>;
}

export function useEntityCommands(): EntityCommandContextValue {
  return useContext(EntityCommandContext);
}
