import sys

for pkg in ['pypdf', 'pdfplumber', 'pypdf2', 'easyocr', 'PIL']:
    try:
        __import__(pkg)
        print(f'{pkg}: OK')
    except ImportError:
        print(f'{pkg}: NOT INSTALLED')
