declare const __APP_EDITION__: string;
declare const __APP_NAME__: string;

/** 'alpha' | 'stable' */
export const APP_EDITION: string = __APP_EDITION__;
/** Display product name, e.g. 'Little Claude' / 'Little Claude Alpha' */
export const APP_NAME: string = __APP_NAME__;
export const IS_ALPHA = APP_EDITION === 'alpha';
