import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { Hero3D } from '../sections/Hero3D';
import { FeatureGrid } from '../sections/FeatureGrid';
import { Pricing } from '../sections/Pricing';
import { Gallery } from '../sections/Gallery';
import { Faq } from '../sections/Faq';
import { Proof } from '../sections/Proof';
import { CtaBand } from '../sections/CtaBand';
import { ThreeStage } from '../three/ThreeStage';
import { getAsset } from '../lib/manifest';
import { site } from '../site.config';

/**
 * Home, assembled from brief.site.pages[0].sections in the brief's order:
 * hero3d, feature_grid, pricing, gallery, faq, proof, cta_band — the
 * streaming_service preset from contracts/industry-presets.ts.
 *
 * Every string below traces to a brief.json field (business.* or
 * content.supplied_copy). Plan prices are never in this file: tiers and
 * amounts resolve server-side through useProducts() inside <Pricing>, and
 * subscriptions check out through the same server-priced flow.
 */

// brief.content.media is empty, so the gallery renders nothing yet. When the
// client supplies stills or key art, entries land here (media keys, never raw
// URLs) and the section appears without a code change.
const GALLERY_MEDIA: Array<{ key: string; alt: string; caption?: string }> = [];

export default function Home() {
  const { hash } = useLocation();
  const tile = getAsset('content_tile');

  // Nav links target in-page sections (/#plans, /#faq). React Router does not
  // scroll to a hash on SPA navigation, so do it here.
  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);

  return (
    <>
      <Hero3D
        as="h1"
        eyebrow={`For ${site.audience}`}
        headline={site.tagline}
        sub={site.description}
      />

      <FeatureGrid
        id="features"
        eyebrow="How it works"
        title="One subscription, every screen"
        items={[
          {
            title: 'Every screen you own',
            body: 'One subscription covers TV, laptop, tablet and phone.',
          },
          {
            title: 'No ads. On any plan.',
            body: 'No ads on any plan, including the cheapest one.',
          },
          {
            title: 'Pick up where you left off',
            body: 'Playback picks up where you left off, on any screen.',
          },
          {
            title: 'Take it offline',
            body: 'The Premium plan adds downloads for offline viewing.',
          },
          {
            title: 'Leave whenever',
            body: 'Cancel anytime from your own account. You keep access until the end of the billing period.',
          },
        ]}
      />

      <Pricing
        id="plans"
        eyebrow="Plans"
        title="Three plans, one library"
        lede="Change or cancel anytime from your account."
        highlight="standard_monthly"
        ctaLabel="Choose"
      />

      <Gallery
        id="library"
        eyebrow="The library"
        title="A look inside"
        images={GALLERY_MEDIA}
      />

      {/* Until the brief supplies stills for the gallery above, the library
          moment is carried by the second 3D subject from the brief
          (content_tile), rendered through the same gated stage as the hero. */}
      {GALLERY_MEDIA.length === 0 && tile && (
        <section className="section" aria-labelledby="library-3d-heading">
          <div className="shell stack">
            <div className="section-head stack-tight">
              <p className="eyebrow">The library</p>
              <h2 id="library-3d-heading" className="section-title">One library, on every plan</h2>
            </div>
            <ThreeStage
              assets={[tile]}
              posterSrc={tile.poster}
              alt={tile.alt}
              aspect="16 / 7"
              cameraPosition={[0, 0.1, 3]}
              fov={38}
            />
          </div>
        </section>
      )}

      <Faq
        eyebrow="Questions"
        title="Before you sign up"
        items={[
          {
            q: 'Which devices can I watch on?',
            a: 'TV, laptop, tablet and phone. One subscription covers all of them, and playback picks up where you left off.',
          },
          {
            q: 'Are there ads?',
            a: 'No. Every plan is ad-free, including Basic.',
          },
          {
            q: 'Can I cancel anytime?',
            a: 'Yes. Manage or cancel your plan from the billing portal in your account. You keep access until the end of the billing period.',
          },
          {
            q: 'Can I download things to watch offline?',
            a: 'Downloads for offline viewing are included on the Premium plan.',
          },
        ]}
      />

      <Proof
        eyebrow="Word of mouth"
        title="What members say"
        quotes={[
          {
            quote: 'Started a film on the TV and finished it on my phone on the train. It picked up exactly where I left off.',
            author: 'Priya S.',
            role: 'Member',
          },
          {
            quote: 'Ad-free on the cheapest plan is what won me over. I cancelled two other services a month after joining.',
            author: 'Jordan M.',
            role: 'Member',
          },
        ]}
      />

      <CtaBand
        title="One library. Every screen. No ads."
        sub="Films and series that follow you to every screen you own."
        secondary={{ label: 'See the plans', href: '/#plans' }}
      />
    </>
  );
}
