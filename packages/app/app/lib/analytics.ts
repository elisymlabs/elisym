declare global {
  interface Window {
    umami?: {
      track: (event: string, data?: Record<string, string | number>) => void;
    };
  }
}

export function track(event: string, data?: Record<string, string | number>) {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return;
  }
  window.umami?.track(event, data);
}
