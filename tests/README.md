# Тесты

Перед каждой публикацией прогоняются два набора проверок экрана чтения:

- `webkit_reader.py` — в WebKit, движке Safari на iPhone (листание, тапы, поток, прокрутка);
- `touch_reader.js` — в Chromium с настоящими касаниями (как пальцем) и импорт всех форматов.

## Запуск

```sh
python3 tests/make_books.py                       # тестовые книги в tests/books/
python3 -m http.server 8123 &                     # приложение из корня репозитория
xvfb-run -a WebKitWebDriver --port=4444 &         # apt: webkit2gtk-driver xvfb; pip: selenium
python3 tests/webkit_reader.py
node tests/touch_reader.js                        # нужен playwright
```
