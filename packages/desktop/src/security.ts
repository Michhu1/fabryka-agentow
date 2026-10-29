type PermissionSession = {
  setPermissionRequestHandler(
    handler: (webContents: unknown, permission: string, callback: (granted: boolean) => void) => void,
  ): void;
  setPermissionCheckHandler(handler: (webContents: unknown, permission: string) => boolean): void;
};

/** Electron grants every permission by default; the app needs none yet, so deny all. */
export function hardenSession(session: PermissionSession): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}

export function isExternal(url: string, appOrigin: string): boolean {
  try {
    return new URL(url).origin !== new URL(appOrigin).origin;
  } catch {
    return true;
  }
}
