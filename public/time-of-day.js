/** Times of day the town can show, in menu order. Each has a lighting preset in presentation.config.json timesOfDay. */
export const TIMES=['dawn','day','sunset','night'];
/**
 * What every preset sets. Colours: sky (the horizon: fog and the foot of the sky gradient), skyTop (the gradient's top),
 * hemiSky/hemiGround (hemisphere light), sun (sun or moon), terrain (tints the meadow and the paving) and water. Numbers with their valid range: light intensities, tone-mapping exposure, glow (window and
 * lamp emissive intensity) and how lit the lamp pools and street lights, stars and fireflies are (0 off .. 1 full).
 * sunFrom: the sun's offset from the view target [x, y, z], y > 0; lower y gives longer shadows.
 */
export const LIGHT_COLOURS=['sky','skyTop','hemiSky','hemiGround','sun','terrain','water'];
export const LIGHT_NUMBERS={hemi:[0,5],sunIntensity:[0,5],exposure:[.3,2.5],glow:[0,4],lamps:[0,1],stars:[0,1],fireflies:[0,1]};
