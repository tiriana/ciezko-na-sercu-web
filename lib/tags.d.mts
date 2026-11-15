type TagLike = { id?: string; label: string; type: string; at?: number };

export declare const tagId: (label: string) => string;
export declare const splitTag: <T extends TagLike>(tag: T) => T[];
export declare const splitTags: <T extends TagLike>(tags: T[]) => T[];
