document.getElementById('myButton').addEventListener('click', function() {
    alert('Dziękujemy za zainteresowanie! Skontaktujemy się z Tobą wkrótce.');
});

document.querySelectorAll('.beer-item').forEach(function(item) {
    item.addEventListener('click', function() {
        const beerName = this.querySelector('h3').textContent;
        alert('Wybrałeś: ' + beerName + '. Sprawdź szczegóły na naszej stronie!');
    });
});

// Smooth scrolling for navigation links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        document.querySelector(this.getAttribute('href')).scrollIntoView({
            behavior: 'smooth'
        });
    });
});