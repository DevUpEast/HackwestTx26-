import os
import random
import re
import time
from html import escape
from html.parser import HTMLParser

from flask import Flask, flash, redirect, render_template, request, session, url_for
from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import inspect, text
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///site.db'
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key-change-me')

db = SQLAlchemy(app)

# A gap this long between board views starts the ad pacing over from the delay.
BOARD_IDLE_RESET_SECONDS = 300


class User(db.Model):
    __tablename__ = 'users'

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    is_admin = db.Column(db.Boolean, nullable=False, default=False)

    posts = db.relationship('Post', back_populates='user', cascade='all, delete-orphan')
    settings = db.relationship(
        'Settings', back_populates='user', uselist=False, cascade='all, delete-orphan'
    )
    favorite_posts = db.relationship(
        'Post', secondary='favorites', back_populates='favorited_by'
    )


class Post(db.Model):
    __tablename__ = 'posts'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    tags = db.Column(db.String(255))
    title = db.Column(db.String(255), nullable=False, default='')
    body_html = db.Column(db.Text, nullable=False, default='')
    image_url = db.Column(db.String(500), nullable=True)
    # Kept for compatibility with the original database and older callers.
    content = db.Column(db.Text, nullable=False)

    user = db.relationship('User', back_populates='posts')
    favorited_by = db.relationship(
        'User', secondary='favorites', back_populates='favorite_posts'
    )

    @property
    def priority(self):
        priority_by_tag = {
            'product': 5,
            'people': 5,
            'community': 4,
            'design': 4,
            'focus': 4,
            'prototype': 4,
            'ideas': 3,
            'experiments': 3,
            'tools': 3,
            'shipping': 3,
            'questions': 2,
        }
        return max((priority_by_tag.get(tag.strip(), 2) for tag in self.tags.split(',')), default=2)

    @property
    def safe_body_html(self):
        return sanitize_html(self.body_html)

    @property
    def is_ad(self):
        return False

    @property
    def author_name(self):
        return f'@{self.user.username}'


class TagPreference(db.Model):
    __tablename__ = 'tag_preferences'

    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), primary_key=True)
    tag = db.Column(db.String(80), primary_key=True)
    likes = db.Column(db.Integer, nullable=False, default=0)
    dislikes = db.Column(db.Integer, nullable=False, default=0)

    @property
    def score(self):
        return self.likes * 2 - self.dislikes


class Ad(db.Model):
    __tablename__ = 'ads'

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(255), nullable=False)
    body_html = db.Column(db.Text, nullable=False)
    tags = db.Column(db.String(255), nullable=False, default='sponsored')
    sponsor = db.Column(db.String(120), nullable=False, default='Hackwest sponsor')
    image_url = db.Column(db.String(500), nullable=True)
    enabled = db.Column(db.Boolean, nullable=False, default=True)

    @property
    def is_ad(self):
        return True

    @property
    def author_name(self):
        return self.sponsor

    @property
    def priority(self):
        return 2

    @property
    def safe_body_html(self):
        return sanitize_html(self.body_html)


class AdSettings(db.Model):
    __tablename__ = 'ad_settings'

    id = db.Column(db.Integer, primary_key=True, default=1)
    enabled = db.Column(db.Boolean, nullable=False, default=True)
    delay_seconds = db.Column(db.Integer, nullable=False, default=60)
    ramp_seconds = db.Column(db.Integer, nullable=False, default=180)


class SafeHtmlParser(HTMLParser):
    allowed_tags = {
        'p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote', 'a', 'img',
        'h2', 'h3', 'code', 'pre',
    }
    blocked_tags = {'script', 'style', 'iframe', 'object', 'embed'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.output = []
        self.blocked_depth = 0

    def handle_starttag(self, tag, attrs):
        if self.blocked_depth:
            self.blocked_depth += 1
            return
        if tag in self.blocked_tags:
            self.blocked_depth = 1
            return
        if tag not in self.allowed_tags:
            return
        if tag == 'a':
            href = dict(attrs).get('href', '')
            if not href.lower().startswith(('https://', 'http://', 'mailto:')):
                return
            self.output.append(f'<a href="{escape(href, quote=True)}" rel="noopener noreferrer">')
            return
        if tag == 'img':
            src = dict(attrs).get('src', '')
            alt = dict(attrs).get('alt', '')
            if src.lower().startswith(('https://', 'http://')):
                self.output.append(
                    f'<img src="{escape(src, quote=True)}" alt="{escape(alt, quote=True)}">'
                )
            return
        self.output.append(f'<{tag}>')

    def handle_startendtag(self, tag, attrs):
        if tag == 'br':
            self.output.append('<br>')

    def handle_endtag(self, tag):
        if self.blocked_depth:
            self.blocked_depth -= 1
            return
        if tag in self.allowed_tags and tag != 'br':
            self.output.append(f'</{tag}>')

    def handle_data(self, data):
        if self.blocked_depth:
            return
        self.output.append(escape(data))


def sanitize_html(value):
    parser = SafeHtmlParser()
    parser.feed(value or '')
    parser.close()
    return ''.join(parser.output)


def markdown_to_html(value):
    escaped_lines = [escape(line) for line in (value or '').splitlines()]
    blocks = []
    paragraph = []
    list_tag = None

    def inline_markup(text):
        text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
        text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
        text = re.sub(r'__(.+?)__', r'<strong>\1</strong>', text)
        text = re.sub(r'(?<!\*)\*(?!\s)(.+?)(?<!\s)\*', r'<em>\1</em>', text)
        text = re.sub(r'(?<!_)_(?!\s)(.+?)(?<!\s)_', r'<em>\1</em>', text)
        return re.sub(r'\[([^]]+)\]\((https?://[^)]+)\)', r'<a href="\2">\1</a>', text)

    def flush_paragraph():
        nonlocal paragraph
        if paragraph:
            blocks.append(f'<p>{inline_markup(" ".join(paragraph))}</p>')
            paragraph = []

    def close_list():
        nonlocal list_tag
        if list_tag:
            blocks.append(f'</{list_tag}>')
            list_tag = None

    for line in escaped_lines:
        if not line.strip():
            flush_paragraph()
            close_list()
        elif line.startswith('### '):
            flush_paragraph()
            close_list()
            blocks.append(f'<h3>{inline_markup(line[4:])}</h3>')
        elif line.startswith('## ' ) or line.startswith('# '):
            flush_paragraph()
            close_list()
            heading = line[3:] if line.startswith('## ') else line[2:]
            blocks.append(f'<h2>{inline_markup(heading)}</h2>')
        elif line.startswith('&gt; '):
            flush_paragraph()
            close_list()
            blocks.append(f'<blockquote>{inline_markup(line[5:])}</blockquote>')
        elif re.match(r'^[-*] ', line):
            flush_paragraph()
            if list_tag != 'ul':
                close_list()
                blocks.append('<ul>')
                list_tag = 'ul'
            blocks.append(f'<li>{inline_markup(line[2:])}</li>')
        elif re.match(r'^\d+\. ', line):
            flush_paragraph()
            if list_tag != 'ol':
                close_list()
                blocks.append('<ol>')
                list_tag = 'ol'
            blocks.append(f'<li>{inline_markup(re.sub(r"^\d+\. ", "", line))}</li>')
        else:
            close_list()
            paragraph.append(line)

    flush_paragraph()
    close_list()
    return ''.join(blocks)


class Settings(db.Model):
    __tablename__ = 'settings'

    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), primary_key=True)
    theme = db.Column(db.String(30), nullable=False, default='light')

    user = db.relationship('User', back_populates='settings')


class Favorite(db.Model):
    __tablename__ = 'favorites'

    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), primary_key=True)
    post_id = db.Column(db.Integer, db.ForeignKey('posts.id'), primary_key=True)


with app.app_context():
    db.create_all()
    user_columns = {column['name'] for column in inspect(db.engine).get_columns('users')}
    if 'is_admin' not in user_columns:
        db.session.execute(text("ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT 0"))
    columns = {column['name'] for column in inspect(db.engine).get_columns('posts')}
    if 'title' not in columns:
        db.session.execute(text("ALTER TABLE posts ADD COLUMN title VARCHAR(255) DEFAULT ''"))
    if 'body_html' not in columns:
        db.session.execute(text("ALTER TABLE posts ADD COLUMN body_html TEXT DEFAULT ''"))
    if 'image_url' not in columns:
        db.session.execute(text("ALTER TABLE posts ADD COLUMN image_url VARCHAR(500)"))
    db.session.commit()


def seed_synthetic_data():
    demo_user = User.query.filter_by(username='Admin').first()
    if demo_user is None:
        demo_user = User(
            username='Admin',
            password_hash=generate_password_hash('password1234'),
            is_admin=True,
            settings=Settings(theme='lime'),
        )
        db.session.add(demo_user)
        db.session.flush()
    elif not demo_user.is_admin:
        demo_user.is_admin = True

    posts = [
        ('Make onboarding feel like a first win, not a form.', 'product, onboarding', '<p>Good onboarding gives someone a small victory before it asks for commitment.</p><p>Start with one useful action, show the result, and let the next step reveal itself. A clear first win creates the confidence to keep exploring.</p>'),
        ('A community grows faster when sharing feels effortless.', 'community, growth', '<p>People contribute when the social cost of joining is low.</p><p>Make room for unfinished thoughts, respond with care, and give useful contributions a visible place to travel. Community is built through repeated invitations.</p>'),
        ('What if every rough idea had a place to land?', 'ideas, collaboration', '<p>Ideas become easier to improve when they do not have to arrive polished.</p><p>A shared landing place lets a team notice patterns, connect distant questions, and return to promising fragments when the timing is right.</p>'),
        ('Small experiments compound into surprising products.', 'experiments, build', '<p>A small experiment is a question with a deadline.</p><p>Choose one uncertain assumption, make it visible, and learn from what happens. Several modest signals can add up to a direction no meeting could have predicted.</p>'),
        ('Design for the moment someone decides to come back.', 'design, retention', '<p>Retention begins with the feeling that returning will be worth the effort.</p><p>Remember what mattered, remove needless friction, and leave one unfinished thread that is genuinely useful to pick up again.</p>'),
        ('The best tools leave room for people to surprise you.', 'tools, creativity', '<p>Tools should support judgment without trying to replace it.</p><p>Leave space for interpretation, unusual inputs, and the happy accident that reveals a better way to work.</p>'),
        ('Ship the useful version, then listen closely.', 'shipping, feedback', '<p>Shipping creates evidence that planning alone cannot.</p><p>Put a useful version in someone\'s hands, watch where they hesitate, and let those observations shape the next release.</p>'),
        ('A good constraint can turn noise into direction.', 'focus, strategy', '<p>Constraints are not only limitations. They are agreements about where attention belongs.</p><p>Name the boundary clearly, then use it to make the next decision smaller and more concrete.</p>'),
        ('Good questions make the next step easier to see.', 'questions, clarity', '<p>The right question changes the shape of a problem.</p><p>Ask what must be true, who is affected, and what could be learned quickly. Clarity often arrives one honest question at a time.</p>'),
        ('Build the smallest bridge between an idea and a real person.', 'prototype, people', '<p>An idea gains momentum when it meets a real person.</p><p>Build the smallest bridge you can: a sketch, a conversation, or a rough prototype. Feedback makes the idea more specific and more generous.</p>'),
    ]
    seeded_body_by_title = {title: body_html for title, _, body_html in posts}
    for post in Post.query.all():
        if not post.title:
            post.title = post.content
        if not post.body_html:
            post.body_html = f'<p>{escape(post.content)}</p>'
        placeholder = f'<p>{escape(post.title)}</p>'
        if post.body_html == placeholder and post.title in seeded_body_by_title:
            post.body_html = seeded_body_by_title[post.title]
    existing_titles = {post.title for post in Post.query.all()}
    missing_posts = [
        Post(user_id=demo_user.id, title=title, content=title, body_html=body_html, tags=tags)
        for title, tags, body_html in posts
        if title not in existing_titles
    ]
    db.session.add_all(missing_posts)
    if db.session.get(AdSettings, 1) is None:
        db.session.add(AdSettings(id=1))
    ad_catalog = [
        ('A calmer way to plan the next release', '<p>SignalDesk turns scattered notes into a clear, shared release picture.</p><p>Try the demo and keep the important work visible.</p>', 'SignalDesk', 'tools, planning'),
        ('Your best ideas deserve a place to grow', '<p>Sketchbook gives early ideas room to become specific without demanding polish on day one.</p>', 'Sketchbook', 'ideas, creativity'),
        ('Make feedback useful before it gets loud', '<p>Loopback helps teams turn thoughtful feedback into small experiments and better decisions.</p>', 'Loopback', 'community, feedback'),
        ('A tiny ritual for better focus', '<p>Set one intention, protect one hour, and leave a note for your future self.</p>', 'Good Hour', 'focus, wellbeing'),
        ('Build with evidence, not volume', '<p>Fieldnote makes it easier to capture what people actually do and learn from it together.</p>', 'Fieldnote', 'research, product'),
    ]
    existing_ads = {ad.title for ad in Ad.query.all()}
    db.session.add_all(
        Ad(title=title, body_html=body_html, sponsor=sponsor, tags=tags)
        for title, body_html, sponsor, tags in ad_catalog
        if title not in existing_ads
    )
    db.session.commit()


with app.app_context():
    seed_synthetic_data()


def split_tags(value):
    return [tag.strip().lower() for tag in (value or '').split(',') if tag.strip()]


def recommended_posts(user, limit=10):
    posts = Post.query.order_by(Post.id.desc()).all()
    if not posts:
        return []

    preferences = {}
    if user is not None:
        preferences = {
            preference.tag: preference.score
            for preference in TagPreference.query.filter_by(user_id=user.id).all()
        }
    randomizer = random.Random(time.time_ns())
    remaining = posts[:]
    selected = []
    tag_usage = {}
    while remaining and len(selected) < limit:
        def candidate_score(post):
            tags = split_tags(post.tags)
            affinity = sum(preferences.get(tag, 0) for tag in tags)
            novelty = sum(1 for tag in tags if not tag_usage.get(tag))
            repetition = sum(tag_usage.get(tag, 0) for tag in tags)
            return affinity + novelty * 2.2 - repetition * 1.8 + post.priority * 0.12 + randomizer.random() * 0.3

        chosen = max(remaining, key=candidate_score)
        remaining.remove(chosen)
        selected.append(chosen)
        for tag in split_tags(chosen.tags):
            tag_usage[tag] = tag_usage.get(tag, 0) + 1
    return selected


def ad_pacing_signature(settings):
    return '{}:{}:{}'.format(
        int(bool(settings.enabled)), settings.delay_seconds, settings.ramp_seconds,
    )


def board_elapsed_seconds(settings):
    """Seconds since this browser's ad clock started.

    The clock restarts when the pacing settings change and when the board has
    not been viewed for a while, so the delay is honoured on every fresh visit
    instead of only the first one in a browser session.
    """
    now = time.time()
    started_at = session.get('board_started_at')
    last_seen = session.get('board_last_seen') or started_at
    signature = ad_pacing_signature(settings)
    restart = (
        started_at is None
        or session.get('board_pacing') != signature
        or now - last_seen > BOARD_IDLE_RESET_SECONDS
    )
    if restart:
        started_at = now
        session['board_started_at'] = started_at
        session['board_pacing'] = signature
    session['board_last_seen'] = now
    return max(0, now - started_at)


def ad_count_for(settings, item_limit):
    if not settings.enabled or item_limit <= 0:
        return 0
    elapsed = board_elapsed_seconds(settings)
    if elapsed < settings.delay_seconds:
        return 0
    if settings.ramp_seconds <= 0:
        return item_limit
    progress = min(1, (elapsed - settings.delay_seconds) / settings.ramp_seconds)
    return min(item_limit, max(1, int(progress * item_limit + 0.999)))


@app.route('/')
@app.route('/home')
def home():
    user = db.session.get(User, session['user_id']) if 'user_id' in session else None
    item_limit = 10
    posts = recommended_posts(user, item_limit)
    ad_settings = db.session.get(AdSettings, 1) or AdSettings(id=1)
    ad_count = ad_count_for(ad_settings, item_limit)
    ads = Ad.query.filter_by(enabled=True).order_by(Ad.id).all()
    ad_count = min(ad_count, len(ads))
    board_items = posts[:item_limit - ad_count] + ads[:ad_count]
    random.SystemRandom().shuffle(board_items)
    return render_template(
        'index.html', user=user, posts=board_items,
        ad_settings=ad_settings, ad_count=ad_count,
    )


@app.post('/api/reactions')
def record_reaction():
    if 'user_id' not in session:
        return {'ok': False, 'message': 'Log in to personalize recommendations.'}, 401
    payload = request.get_json(silent=True) or {}
    post_id = payload.get('post_id')
    reaction = payload.get('reaction')
    post = db.session.get(Post, post_id) if post_id else None
    if post is None or reaction not in {'like', 'dislike'}:
        return {'ok': False, 'message': 'Invalid reaction.'}, 400
    user_id = session['user_id']
    for tag in split_tags(post.tags):
        preference = db.session.get(TagPreference, (user_id, tag))
        if preference is None:
            preference = TagPreference(user_id=user_id, tag=tag, likes=0, dislikes=0)
            db.session.add(preference)
        if reaction == 'like':
            preference.likes = (preference.likes or 0) + 1
        else:
            preference.dislikes = (preference.dislikes or 0) + 1
    db.session.commit()
    return {'ok': True}


@app.route('/admin/settings', methods=['GET', 'POST'])
def admin_settings():
    user = db.session.get(User, session['user_id']) if 'user_id' in session else None
    if user is None or not user.is_admin:
        flash('Admin access is required.', 'error')
        return redirect(url_for('home'))
    settings = db.session.get(AdSettings, 1) or AdSettings(id=1)
    if request.method == 'POST':
        try:
            delay_seconds = max(0, int(request.form.get('delay_seconds', 60)))
            ramp_seconds = max(0, int(request.form.get('ramp_seconds', 180)))
        except ValueError:
            flash('Ad timing values must be whole numbers.', 'error')
        else:
            settings.enabled = request.form.get('enabled') == 'on'
            settings.delay_seconds = delay_seconds
            settings.ramp_seconds = ramp_seconds
            db.session.add(settings)
            db.session.commit()
            flash('Ad pacing saved.', 'success')
            return redirect(url_for('admin_settings'))
    return render_template('admin_settings.html', settings=settings)


@app.route('/posts/new', methods=['GET', 'POST'])
def create_post():
    if 'user_id' not in session:
        flash('Log in to create a post.', 'error')
        return redirect(url_for('login'))

    if request.method == 'POST':
        title = request.form.get('title', '').strip()
        body_html = request.form.get('body_html', '').strip()
        tags = request.form.get('tags', '').strip()
        image_url = request.form.get('image_url', '').strip()

        if not title or len(title) > 255:
            flash('Add a title up to 255 characters.', 'error')
        elif not body_html:
            flash('Add some article content.', 'error')
        elif image_url and not image_url.lower().startswith(('https://', 'http://')):
            flash('Image URLs must begin with http:// or https://.', 'error')
        else:
            post = Post(
                user_id=session['user_id'],
                title=title,
                content=title,
                body_html=sanitize_html(markdown_to_html(body_html)),
                image_url=image_url or None,
                tags=tags or 'ideas',
            )
            db.session.add(post)
            db.session.commit()
            flash('Your post is live.', 'success')
            return redirect(url_for('home'))

    return render_template('create_post.html')


@app.route('/signup', methods=['GET', 'POST'])
@app.route('/register', methods=['GET', 'POST'])
def signup():
    if 'user_id' in session:
        return redirect(url_for('home'))

    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        confirm_password = request.form.get('confirm_password', '')

        if len(username) < 3:
            flash('Username must be at least 3 characters long.', 'error')
        elif len(password) < 8:
            flash('Password must be at least 8 characters long.', 'error')
        elif password != confirm_password:
            flash('Passwords do not match.', 'error')
        elif User.query.filter_by(username=username).first():
            flash('That username is already taken.', 'error')
        else:
            user = User(
                username=username,
                password_hash=generate_password_hash(password),
                settings=Settings(),
            )
            db.session.add(user)
            db.session.commit()
            session['user_id'] = user.id
            flash('Your account has been created.', 'success')
            return redirect(url_for('home'))

    return render_template('signup.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    if 'user_id' in session:
        return redirect(url_for('home'))

    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        user = User.query.filter_by(username=username).first()

        if user is None or not check_password_hash(user.password_hash, password):
            flash('Invalid username or password.', 'error')
        else:
            session.clear()
            session['user_id'] = user.id
            return redirect(url_for('home'))

    return render_template('login.html')


@app.post('/logout')
def logout():
    session.clear()
    flash('You have been logged out.', 'success')
    return redirect(url_for('login'))


if __name__ == '__main__':
    app.run(debug=True)