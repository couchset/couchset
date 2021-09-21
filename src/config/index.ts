import 'dotenv/config';
import {get as _get} from 'lodash';

export const nodeEnv = _get(process.env, 'NODE_ENV');
export const isDev = nodeEnv !== 'production';
