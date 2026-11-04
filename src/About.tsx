import { AUTHOR_NAME, AUTHOR_URL, PROJECT_URL } from '../shared/about';
import { api } from './api';
import { Modal } from './ui';

function ExternalLink({ url }: { url: string }) {
  return (
    <button className="link" onClick={() => void api.openLink(url)}>
      {url.replace('https://', '')}
    </button>
  );
}

export function About({ onClose }: { onClose(): void }) {
  return (
    <Modal title="À propos de Clairière" onClose={onClose}>
      <div className="about-head">
        <img src="./icon.svg" alt="" width={44} height={44} />
        <div>
          <strong>Clairière</strong>
          <span className="muted num">Version {__APP_VERSION__}</span>
        </div>
      </div>
      <dl className="about-list">
        <div>
          <dt>Développeur</dt>
          <dd>{AUTHOR_NAME}</dd>
        </div>
        <div>
          <dt>GitHub</dt>
          <dd><ExternalLink url={AUTHOR_URL} /></dd>
        </div>
        <div>
          <dt>Projet</dt>
          <dd><ExternalLink url={PROJECT_URL} /></dd>
        </div>
      </dl>
      <div className="modal-actions">
        <span className="spacer" />
        <button className="btn" data-autofocus onClick={onClose}>Fermer</button>
      </div>
    </Modal>
  );
}
