export const usePublicPath = () => {
  const config = useRuntimeConfig();

  return (path: string) => {
    // Remove leading slash if present
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;

    // Get base URL, ensure it ends with /
    const baseURL = config.app.baseURL.endsWith('/')
      ? config.app.baseURL
      : config.app.baseURL + '/';

    return `${baseURL}${cleanPath}`;
  };
};