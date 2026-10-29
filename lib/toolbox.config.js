/*
 * Site configuration for storage providers. Loaded first, by every page.
 *
 * Google Drive: fill in all three values to show the "Google Drive" option (see
 * "Google Drive setup" in README.md). None of them are secrets — the browser
 * sign-in flow has no client secret — but restrict them to this site's origins
 * in Google Cloud Console.
 *
 *   clientId  OAuth client ID (Web application), "….apps.googleusercontent.com"
 *   apiKey    API key restricted to the Google Picker API and this site's origins
 *   appId     Google Cloud project number (digits only)
 */
window.TOOLBOX_CONFIG = {
  google: {
    clientId: '',
    apiKey: '',
    appId: ''
  }
};
