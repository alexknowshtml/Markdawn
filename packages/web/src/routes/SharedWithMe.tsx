import { Navigate } from 'react-router-dom';

export default function SharedWithMe() {
  return <Navigate to="/app?filter=shared-with-me" replace />;
}
