import os

from flask import Flask, flash, redirect, render_template, request, session, url_for
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///site.db'
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key-change-me')

db = SQLAlchemy(app)


class User(db.Model):
    __tablename__ = 'users'

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)

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
    content = db.Column(db.Text, nullable=False)

    user = db.relationship('User', back_populates='posts')
    favorited_by = db.relationship(
        'User', secondary='favorites', back_populates='favorite_posts'
    )


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


def seed_synthetic_data():
    if Post.query.count() > 0:
        return

    demo_user = User.query.filter_by(username='hackwest_demo').first()
    if demo_user is None:
        demo_user = User(
            username='hackwest_demo',
            password_hash=generate_password_hash('hackwest-demo-password'),
            settings=Settings(theme='lime'),
        )
        db.session.add(demo_user)
        db.session.flush()

    posts = [
        ('Make onboarding feel like a first win, not a form.', 'product, onboarding'),
        ('A community grows faster when sharing feels effortless.', 'community, growth'),
        ('What if every rough idea had a place to land?', 'ideas, collaboration'),
        ('Small experiments compound into surprising products.', 'experiments, build'),
        ('Design for the moment someone decides to come back.', 'design, retention'),
        ('The best tools leave room for people to surprise you.', 'tools, creativity'),
        ('Ship the useful version, then listen closely.', 'shipping, feedback'),
        ('A good constraint can turn noise into direction.', 'focus, strategy'),
    ]
    db.session.add_all(
        [Post(user_id=demo_user.id, content=content, tags=tags) for content, tags in posts]
    )
    db.session.commit()


with app.app_context():
    seed_synthetic_data()


@app.route('/')
@app.route('/home')
def home():
    user = db.session.get(User, session['user_id']) if 'user_id' in session else None
    posts = Post.query.order_by(Post.id.desc()).all()
    return render_template('index.html', user=user, posts=posts)


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