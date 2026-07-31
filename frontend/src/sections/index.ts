/**
 * Section registry.
 *
 * The key strings match the enum in contracts/brief.schema.json exactly. That
 * correspondence is the contract: a brief that validates names only sections
 * that exist here, so generation is a lookup rather than an authoring task.
 *
 * If you add a section, add it to the schema enum in the same commit. A section
 * here that the schema does not know about can never be requested; a section the
 * schema allows that is missing here is the failure this file was written to
 * prevent.
 */
export { Hero3D } from './Hero3D';
export { FeatureGrid } from './FeatureGrid';
export { ProductShowcase3D } from './ProductShowcase3D';
export { ProcessTimeline } from './ProcessTimeline';
export { Proof } from './Proof';
export { Pricing } from './Pricing';
export { Faq } from './Faq';
export { Team } from './Team';
export { Gallery } from './Gallery';
export { ContactForm } from './ContactForm';
export { CtaBand } from './CtaBand';
export { LogoWall } from './LogoWall';
export { StatBand } from './StatBand';
export { EditorialLong } from './EditorialLong';
export { LocationHours } from './LocationHours';
export { Section, SectionHead, Button, SectionStyles } from './shared';
