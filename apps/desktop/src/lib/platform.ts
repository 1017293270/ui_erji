/** The system the app runs on, from the class index.html sets before the first paint. */
export const isMac = document.documentElement.classList.contains("platform-mac");
export const isWindows = document.documentElement.classList.contains("platform-win");
/** The phone app: one window, its own screens (src/mobile), recording through Android. */
export const isMobile = document.documentElement.classList.contains("platform-mobile");
