export type PlatformEvent<T> = { payload: T };
export type PlatformEventHandler<T> = (event: PlatformEvent<T>) => void;
export type Unlisten = () => void;

export interface PlatformEvents {
  listen<T>(event: string, handler: PlatformEventHandler<T>): Promise<Unlisten>;
}
