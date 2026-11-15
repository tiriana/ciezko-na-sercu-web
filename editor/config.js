export const config = {
  owner: 'tiriana',
  repo: 'ciezko-na-sercu-web',
  branch: 'main',
  // Client ID aplikacji GitHub (nie sekret). Pusty = zostaje wklejanie tokenu.
  clientId: '',
  api: 'https://api.github.com',
  raw: 'https://raw.githubusercontent.com',
};

export const rawUrl = (path) => `${config.raw}/${config.owner}/${config.repo}/${config.branch}/${path}`;
