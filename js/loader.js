// Section Loader - Dynamically loads HTML sections
const SECTIONS = [
    { name: 'hero', file: 'sections/hero.html' },
    { name: 'about', file: 'sections/about.html' },
    { name: 'research', file: 'sections/research.html' },
    { name: 'team', file: 'sections/team.html' },
    { name: 'publications', file: 'sections/publications.html' },
    { name: 'resources', file: 'sections/resources.html' },
    { name: 'contact', file: 'sections/contact.html' }
];

const LOCAL_BACKEND_ORIGINS = [
    'http://127.0.0.1:5000',
    'http://localhost:5000'
];

function normalizePath(path) {
    return path.replace(/^\//, '');
}

function buildSectionUrl(sectionFile, baseOrigin = '') {
    const normalizedFile = normalizePath(sectionFile);
    return baseOrigin ? `${baseOrigin}/${normalizedFile}` : normalizedFile;
}

async function findRunningBackendOrigin() {
    for (const origin of LOCAL_BACKEND_ORIGINS) {
        try {
            const response = await fetch(`${origin}/api/health`, {
                cache: 'no-store'
            });

            if (response.ok) {
                return origin;
            }
        } catch (error) {
            console.warn(`Backend probe failed for ${origin}`, error);
        }
    }

    return null;
}

function renderServerRequiredNotice(sectionsRoot) {
    sectionsRoot.innerHTML = `
        <section class="resources-section">
            <div class="container" style="padding: 4rem 0;">
                <div class="auth-container" style="max-width: 760px; margin: 0 auto;">
                    <div class="auth-header">
                        <div class="auth-lock-icon">
                            <i class="fas fa-server"></i>
                        </div>
                        <h3>Start the Local Site Server</h3>
                        <p>This website was opened as a local file, so the sections and member sign-in cannot load.</p>
                    </div>
                    <div class="auth-form" style="display: grid; gap: 1rem;">
                        <p>Run <strong>python app.py</strong> from the project folder and open <strong>http://127.0.0.1:5000</strong>.</p>
                        <p class="auth-note"><i class="fas fa-info-circle"></i> The resources section and sign-in use the Flask backend and will not work from file://.</p>
                    </div>
                </div>
            </div>
        </section>
    `;
}

// Load all sections into the main container
async function loadSections() {
    const sectionsRoot = document.getElementById('sections-root');

    if (!sectionsRoot) {
        return;
    }

    if (window.location.protocol === 'file:') {
        const backendOrigin = await findRunningBackendOrigin();

        if (backendOrigin) {
            window.location.replace(`${backendOrigin}/`);
            return;
        }

        renderServerRequiredNotice(sectionsRoot);
        return;
    }
    
    for (const section of SECTIONS) {
        try {
            const response = await fetch(buildSectionUrl(section.file));
            if (!response.ok) {
                throw new Error(`Failed to load ${section.file}`);
            }
            const html = await response.text();
            
            // Create a temporary container to parse the HTML
            const temp = document.createElement('div');
            temp.innerHTML = html;
            
            // Append the section content to the main container
            while (temp.firstChild) {
                sectionsRoot.appendChild(temp.firstChild);
            }
        } catch (error) {
            console.error(`Error loading section: ${section.name}`, error);
            // Optionally add an error message to the page
            const errorSection = document.createElement('div');
            errorSection.style.padding = '20px';
            errorSection.style.color = 'red';
            errorSection.textContent = `Error loading ${section.name} section`;
            sectionsRoot.appendChild(errorSection);
        }
    }
    
    console.log('All sections loaded successfully');
    // Dispatch custom event when all sections are loaded
    document.dispatchEvent(new CustomEvent('sectionsLoaded'));
}

// Load sections when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadSections);
} else {
    loadSections();
}
