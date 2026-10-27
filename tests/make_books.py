"""Creates small test books in tests/books/ (EPUB, FB2 in windows-1251, zipped variants, TXT)."""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'books')
os.makedirs(OUT, exist_ok=True)

PARAS = [
    'Дао, которое может быть выражено словами, не есть постоянное Дао. Имя, которое может быть названо, не есть постоянное имя.',
    'Безымянное есть начало неба и земли, обладающее именем — мать всех вещей.',
    'Поэтому тот, кто свободен от страстей, видит чудесную тайну Дао, а кто имеет страсти, видит его только в конечной форме.',
]


def epub_entries():
    body = ''.join(f'<p>{p}<sup>1</sup></p>' for p in PARAS * 40)
    return {
        'mimetype': 'application/epub+zip',
        'META-INF/container.xml': '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        'OEBPS/content.opf': '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Дао дэ цзин</dc:title><dc:creator>Лао-цзы</dc:creator></metadata>'
                             '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/ch%201.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
        'OEBPS/nav.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/ch%201.xhtml">Глава 1</a></li><li><a href="text/ch2.xhtml#x">Глава 2</a></li></ol></nav></body></html>',
        'OEBPS/text/ch 1.xhtml': f'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><h1>Глава 1</h1>{body}</body></html>',
        'OEBPS/text/ch2.xhtml': f'<html xmlns="http://www.w3.org/1999/xhtml"><body><h2>Глава 2</h2><p>Сверхдлинноесловодляпроверкимасштабирования и <i>курсив</i> внутри абзаца.</p>{body}</body></html>',
    }


def write_zip(path, entries, prefix=''):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            z.writestr(prefix + name, data)


write_zip(os.path.join(OUT, 'test.epub'), epub_entries())
write_zip(os.path.join(OUT, 'package.epub.zip'), {'__MACOSX/Book.epub/._mimetype': 'x', **{f'Book.epub/{k}': v for k, v in epub_entries().items()}})

fb2 = ('<?xml version="1.0" encoding="windows-1251"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">'
       '<description><title-info><author><first-name>Герман</first-name><last-name>Гессе</last-name></author><book-title>Сиддхартха</book-title></title-info></description>'
       '<body><section><title><p>Часть первая</p></title><section><title><p>Сын брамина</p></title>'
       + ''.join(f'<p>{p}<a l:href="#n1" type="note">[1]</a></p>' for p in PARAS * 5)
       + '</section><section><title><p>У саманов</p></title>' + ''.join(f'<p>{p}</p>' for p in PARAS * 5)
       + '</section></section></body><body name="notes"><section id="n1"><p>Сноска</p></section></body></FictionBook>').encode('cp1251')
open(os.path.join(OUT, 'test.fb2'), 'wb').write(fb2)
write_zip(os.path.join(OUT, 'test.fb2.zip'), {'book.fb2': fb2})
open(os.path.join(OUT, 'test.txt'), 'wb').write(('Глава 1\n\n' + '\n\n'.join(PARAS * 3) + '\n\nГлава 2\n\n' + '\n\n'.join(PARAS)).encode('cp1251'))
print('books in', OUT)
