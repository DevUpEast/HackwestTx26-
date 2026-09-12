from flask import Flask
from flask_sqlalchemy import SQLAlchemy

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///site.db'

db = SQLAlchemy(app)

@app.route('/')
@app.route('/home')
def home():
    return "Welcome to HackwestTx26!"

if __name__ == '__main__':
    app.run(debug=True)