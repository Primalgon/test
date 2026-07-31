import { Link } from 'react-router';
import { site } from '../site.config';

/**
 * An empty screen is an invitation to act: name what happened and give the
 * two routes onward, rather than an apology and a dead end.
 */
export default function NotFound() {
  return (
    <section className="section shell stack">
      <p className="eyebrow">404</p>
      <h1>That page isn't here</h1>
      <p>The link may be out of date, or the address slightly off.</p>
      <p>
        <Link to="/">Go to the homepage</Link>
        {' · '}
        <Link to="/contact">Ask us where it went</Link>
      </p>
      <p className="eyebrow" style={{ marginBlockStart: '2rem' }}>{site.name}</p>
    </section>
  );
}
