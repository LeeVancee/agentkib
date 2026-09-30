export type DesktopAccountProfile = {
  id: string;
  username: string;
  status: string;
  deviceLimit: number;
  deviceCount: number;
  totpEnabled: boolean;
};
export type DesktopAccountStatus = {
  phase: "signed-out" | "signing-in" | "signed-in" | "error";
  account?: DesktopAccountProfile;
  device?: { deviceId: string; ownership: "unclaimed" | "owned" | "other" };
  error?: string;
  secureStorage: boolean;
};
export type DesktopAccountRequest = {
  operation: "status" | "login" | "cancel-login" | "logout" | "claim" | "manage";
};
