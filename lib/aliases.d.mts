type AliasFile = {
  version: 1;
  aliases: Record<string, string>;
  types: Record<string, string>;
  dismissed: { from: string; to: string }[];
};

export declare const TAG_TYPES: string[];
export declare const emptyAliasFile: () => AliasFile;
export declare const resolveAlias: (label: string, aliases: Record<string, string>) => string;
export declare const normalizeAliasFile: (payload: unknown) => AliasFile;
export declare const aliasFileKey: (file: unknown) => string;
export declare const aliasProblems: (aliases: Record<string, string>) => string[];
